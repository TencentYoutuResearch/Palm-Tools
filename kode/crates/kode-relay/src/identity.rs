//! Account identity for relay requests.
//!
//! CloudBase Auth is a standard OIDC provider: access tokens are RS256 JWTs
//! signed by the keys at `<issuer>/auth/v1/certs`. The relay verifies them
//! locally so routing never depends on a per-request call to the provider.
//! `sub` is the tenant key; nothing else in a request may select a tenant.

use std::{collections::HashMap, future::Future, pin::Pin, sync::Arc, time::Duration};

use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use parking_lot::RwLock;
use serde::Deserialize;

/// Minimum spacing between JWKS refreshes triggered by an unknown `kid`.
/// Without it a stream of forged tokens could hammer the provider.
const JWKS_REFRESH_COOLDOWN: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub user_id: String,
    /// Token expiry in epoch seconds, when the token carries one.
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerifyError {
    /// The token is malformed, expired, or not signed by the provider.
    Invalid,
    /// The provider's keys could not be fetched; retrying may succeed.
    Unavailable,
}

pub type VerifyFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Identity, VerifyError>> + Send + 'a>>;

pub trait IdentityVerifier: Send + Sync + 'static {
    fn verify<'a>(&'a self, token: &'a str) -> VerifyFuture<'a>;
}

#[derive(Debug, Clone)]
pub struct JwksConfig {
    pub issuer: String,
    pub jwks_url: String,
    /// Checked only when set; CloudBase uses the environment id.
    pub audience: Option<String>,
    /// Required `role` claim. The provider's keys also sign API and
    /// publishable keys; only signed-in end users may own a tenant.
    pub required_role: Option<String>,
}

impl JwksConfig {
    /// CloudBase publishes its keys under the issuer origin.
    pub fn cloudbase(issuer: &str) -> Self {
        let issuer = issuer.trim_end_matches('/').to_string();
        Self {
            jwks_url: format!("{issuer}/auth/v1/certs"),
            issuer,
            audience: None,
            required_role: Some("authenticated".into()),
        }
    }
}

pub struct JwksVerifier {
    config: JwksConfig,
    client: reqwest::Client,
    keys: RwLock<KeyCache>,
    refresh: tokio::sync::Mutex<()>,
}

#[derive(Default)]
struct KeyCache {
    keys: HashMap<String, DecodingKey>,
    fetched_at: Option<tokio::time::Instant>,
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
    exp: u64,
    #[serde(default)]
    role: Option<String>,
    #[serde(default)]
    user_type: Option<String>,
}

impl JwksVerifier {
    pub fn new(config: JwksConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .build()
                .expect("relay JWKS HTTP client"),
            keys: RwLock::new(KeyCache::default()),
            refresh: tokio::sync::Mutex::new(()),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_keys(config: JwksConfig, jwks: &str) -> Arc<Self> {
        let verifier = Self::new(config);
        let set: JwkSet = serde_json::from_str(jwks).expect("test JWKS");
        *verifier.keys.write() = KeyCache {
            keys: decoding_keys(&set),
            fetched_at: Some(tokio::time::Instant::now()),
        };
        verifier
    }

    async fn key_for(&self, kid: &str) -> Result<DecodingKey, VerifyError> {
        if let Some(key) = self.keys.read().keys.get(kid) {
            return Ok(key.clone());
        }
        let _guard = self.refresh.lock().await;
        {
            let cache = self.keys.read();
            if let Some(key) = cache.keys.get(kid) {
                return Ok(key.clone());
            }
            if cache
                .fetched_at
                .is_some_and(|at| at.elapsed() < JWKS_REFRESH_COOLDOWN)
            {
                return Err(VerifyError::Invalid);
            }
        }
        let set = self
            .client
            .get(&self.config.jwks_url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| {
                tracing::warn!(%error, "JWKS fetch failed");
                VerifyError::Unavailable
            })?
            .json::<JwkSet>()
            .await
            .map_err(|error| {
                tracing::warn!(%error, "JWKS response invalid");
                VerifyError::Unavailable
            })?;
        let mut cache = self.keys.write();
        *cache = KeyCache {
            keys: decoding_keys(&set),
            fetched_at: Some(tokio::time::Instant::now()),
        };
        cache.keys.get(kid).cloned().ok_or(VerifyError::Invalid)
    }

    async fn verify_token(&self, token: &str) -> Result<Identity, VerifyError> {
        let header = decode_header(token).map_err(|_| VerifyError::Invalid)?;
        if header.alg != Algorithm::RS256 {
            return Err(VerifyError::Invalid);
        }
        let kid = header.kid.ok_or(VerifyError::Invalid)?;
        let key = self.key_for(&kid).await?;
        let mut validation = Validation::new(Algorithm::RS256);
        validation.set_issuer(&[&self.config.issuer]);
        validation.set_required_spec_claims(&["exp", "iss", "sub"]);
        validation.leeway = 30;
        match &self.config.audience {
            Some(audience) => validation.set_audience(&[audience]),
            None => validation.validate_aud = false,
        }
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| VerifyError::Invalid)?
            .claims;
        if claims.sub.trim().is_empty() || claims.sub.len() > 128 {
            return Err(VerifyError::Invalid);
        }
        if self
            .config
            .required_role
            .as_ref()
            .is_some_and(|role| claims.role.as_ref() != Some(role))
            || claims.user_type.as_deref() == Some("anonymous")
        {
            return Err(VerifyError::Invalid);
        }
        Ok(Identity {
            user_id: claims.sub,
            expires_at: Some(claims.exp),
        })
    }
}

impl IdentityVerifier for JwksVerifier {
    fn verify<'a>(&'a self, token: &'a str) -> VerifyFuture<'a> {
        Box::pin(self.verify_token(token))
    }
}

fn decoding_keys(set: &JwkSet) -> HashMap<String, DecodingKey> {
    set.keys
        .iter()
        .filter_map(|jwk| {
            let kid = jwk.common.key_id.clone()?;
            DecodingKey::from_jwk(jwk).ok().map(|key| (kid, key))
        })
        .collect()
}

/// Fixed token table for tests and local development.
pub struct StaticVerifier {
    tokens: RwLock<HashMap<String, String>>,
}

impl StaticVerifier {
    pub fn new(tokens: impl IntoIterator<Item = (String, String)>) -> Arc<Self> {
        Arc::new(Self {
            tokens: RwLock::new(tokens.into_iter().collect()),
        })
    }

    /// Simulates provider-side revocation or expiry.
    pub fn revoke(&self, token: &str) {
        self.tokens.write().remove(token);
    }
}

impl IdentityVerifier for StaticVerifier {
    fn verify<'a>(&'a self, token: &'a str) -> VerifyFuture<'a> {
        let result = self
            .tokens
            .read()
            .get(token)
            .map(|user_id| Identity {
                user_id: user_id.clone(),
                expires_at: None,
            })
            .ok_or(VerifyError::Invalid);
        Box::pin(async move { result })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde_json::json;

    const ISSUER: &str = "https://env-test.api.example.com";
    const KID: &str = "test-kid";
    // A throwaway 2048-bit key generated only for these tests.
    const PRIVATE_PEM: &str = include_str!("../tests/fixtures/test-rsa.pem");
    const MODULUS: &str = include_str!("../tests/fixtures/test-rsa.n");

    fn verifier() -> Arc<JwksVerifier> {
        let jwks = json!({"keys": [{
            "kty": "RSA", "alg": "RS256", "use": "sig", "kid": KID,
            "n": MODULUS.trim(), "e": "AQAB"
        }]});
        JwksVerifier::with_keys(JwksConfig::cloudbase(ISSUER), &jwks.to_string())
    }

    fn token(claims: serde_json::Value, kid: &str) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(kid.into());
        encode(
            &header,
            &claims,
            &EncodingKey::from_rsa_pem(PRIVATE_PEM.as_bytes()).expect("test key"),
        )
        .expect("signed token")
    }

    fn now() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[tokio::test]
    async fn accepts_provider_signed_tokens_and_uses_sub_as_tenant() {
        let verifier = verifier();
        let exp = now() + 600;
        let identity = verifier
            .verify(&token(
                json!({"sub": "user-1", "iss": ISSUER, "exp": exp, "role": "authenticated"}),
                KID,
            ))
            .await
            .expect("valid token");
        assert_eq!(
            identity,
            Identity {
                user_id: "user-1".into(),
                expires_at: Some(exp)
            }
        );
    }

    #[tokio::test]
    async fn only_signed_in_end_users_can_own_a_tenant() {
        let verifier = verifier();
        let exp = now() + 600;
        for claims in [
            json!({"sub": "svc", "iss": ISSUER, "exp": exp}),
            json!({"sub": "svc", "iss": ISSUER, "exp": exp, "role": "service_role"}),
            json!({"sub": "anon", "iss": ISSUER, "exp": exp, "role": "anon"}),
            json!({"sub": "guest", "iss": ISSUER, "exp": exp, "role": "authenticated", "user_type": "anonymous"}),
        ] {
            assert_eq!(
                verifier.verify(&token(claims.clone(), KID)).await,
                Err(VerifyError::Invalid),
                "{claims}"
            );
        }
    }

    #[tokio::test]
    async fn rejects_expired_foreign_issuer_and_unsigned_tokens() {
        let verifier = verifier();
        let expired = token(json!({"sub": "u", "iss": ISSUER, "exp": now() - 600}), KID);
        let foreign = token(
            json!({"sub": "u", "iss": "https://other.example.com", "exp": now() + 600}),
            KID,
        );
        let missing_sub = token(json!({"iss": ISSUER, "exp": now() + 600}), KID);
        for bad in [expired, foreign, missing_sub, "not-a-jwt".to_string()] {
            assert_eq!(verifier.verify(&bad).await, Err(VerifyError::Invalid));
        }
        // An unknown kid cannot trigger a refresh inside the cooldown window.
        let unknown_kid = token(
            json!({"sub": "u", "iss": ISSUER, "exp": now() + 600}),
            "other",
        );
        assert_eq!(
            verifier.verify(&unknown_kid).await,
            Err(VerifyError::Invalid)
        );
    }
}
