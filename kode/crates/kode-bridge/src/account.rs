//! Sign-in for the account relay: CloudBase email codes and PalmX palm scan.
//!
//! The relay advertises its OIDC issuer and the enabled sign-in methods from
//! `/api/v1/healthz`, so the desktop only needs the relay URL. Every method
//! ends with the provider's own CloudBase access/refresh pair; the relay
//! verifies access tokens against the issuer's JWKS.
//!
//! PalmX: the desktop shows PalmX's QR (no secret involved) and polls it;
//! the confirmed code plus our PKCE verifier go to the relay, which holds the
//! PalmX API key and returns CloudBase tokens.
//!
//! Palm (Kode's own 1:N scan): the desktop shows a `kode://palm-login` QR
//! for a relay handoff; the phone scans its palm and approves it, and the
//! desktop collects the tokens once with the handoff secret it kept.

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Refresh this long before expiry so a reconnect never presents a token the
/// relay is about to reject.
pub const REFRESH_MARGIN_MS: u64 = 5 * 60 * 1000;

/// How an account session was obtained. New providers (WeChat, Google) add
/// variants; the relay's `login_methods` decides which ones a user sees.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoginMethod {
    #[default]
    Email,
    Palmx,
    Palm,
}

/// One sign-in method a relay offers, in its preferred order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginMethodInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Palm H5 SDK loader; its origin hosts the SDK's capture frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountSession {
    pub issuer: String,
    /// Empty for methods that carry no address (PalmX).
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub method: LoginMethod,
    /// Display name from the CloudBase profile; empty until the user sets one.
    #[serde(default)]
    pub name: String,
    /// Avatar URL from the CloudBase profile; empty when unset.
    #[serde(default)]
    pub picture: String,
    pub user_id: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Access-token expiry in epoch milliseconds.
    pub expires_at: u64,
}

impl AccountSession {
    pub fn needs_refresh(&self, now_ms: u64) -> bool {
        self.expires_at <= now_ms + REFRESH_MARGIN_MS
    }

    /// What the UI calls this account: its name, else its address, else a
    /// short form of the account id. Never the sign-in method: every method
    /// reaches the same account.
    pub fn label(&self) -> String {
        if !self.name.trim().is_empty() {
            return self.name.trim().to_string();
        }
        if !self.email.is_empty() {
            return self.email.clone();
        }
        let tail: String = self.user_id.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
        format!("Kode · {tail}")
    }
}

/// A PalmX QR is on screen. Holds the PKCE verifier; never persisted.
#[derive(Debug, Clone)]
pub struct PalmxPending {
    pub server_url: String,
    pub issuer: String,
    base_url: String,
    verifier: String,
    session_id: String,
    pub qr_payload: String,
    /// Epoch seconds.
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PalmxStatus {
    Pending,
    Scanned,
    Confirmed { code: String },
    Denied,
    Expired,
}

/// A palm handoff QR is on screen. The secret never leaves this process.
#[derive(Debug, Clone)]
pub struct PalmHandoff {
    pub server_url: String,
    pub issuer: String,
    id: String,
    secret: String,
    pub qr_payload: String,
    /// Epoch seconds.
    pub expires_at: u64,
}

/// A code was emailed; the id must accompany the code the user types.
#[derive(Debug, Clone)]
pub struct PendingSignIn {
    pub server_url: String,
    pub issuer: String,
    pub email: String,
    pub verification_id: String,
    pub is_user: bool,
}

#[derive(Clone)]
pub struct AccountClient {
    http: reqwest::Client,
    /// Stable id of this installation, sent as `x-device-id` on every
    /// sign-in and refresh (as the CloudBase SDK does). When all sign-ins
    /// shared one id, each new one revoked the previous session's refresh
    /// token, so two installs must never share an id.
    device_id: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    sub: Option<String>,
}

impl Default for AccountClient {
    fn default() -> Self {
        Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(8))
                .timeout(Duration::from_secs(15))
                .build()
                .expect("account HTTP client"),
            device_id: None,
        }
    }
}

impl AccountClient {
    pub fn for_device(device_id: String) -> Self {
        Self { device_id: Some(device_id), ..Self::default() }
    }

    fn with_device(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.device_id {
            Some(id) => request.header("x-device-id", id),
            None => request,
        }
    }

    async fn health(&self, server_url: &str) -> Result<Value, String> {
        let health: Value = self
            .http
            .get(format!("{server_url}/api/v1/healthz"))
            .send()
            .await
            .map_err(|error| format!("cannot reach the account relay: {error}"))?
            .json()
            .await
            .map_err(|_| "the server is not a Kode account relay".to_string())?;
        if health["server_kind"] != "kode-relay" {
            return Err("the server is not a Kode account relay".into());
        }
        Ok(health)
    }

    /// Sign-in methods the relay offers. Relays predating the list offer
    /// email only.
    pub async fn login_methods(&self, server_url: &str) -> Result<Vec<LoginMethodInfo>, String> {
        let health = self.health(server_url).await?;
        Ok(parse_login_methods(&health))
    }

    /// Reads the issuer the relay trusts.
    pub async fn relay_issuer(&self, server_url: &str) -> Result<String, String> {
        let health = self.health(server_url).await?;
        health["issuer"]
            .as_str()
            .map(|issuer| issuer.trim_end_matches('/').to_string())
            .filter(|issuer| trusted_issuer(issuer))
            .ok_or_else(|| "the account relay has no sign-in provider configured".into())
    }

    pub async fn send_code(
        &self,
        server_url: &str,
        email: &str,
    ) -> Result<(PendingSignIn, u64), String> {
        let email = email.trim().to_string();
        let issuer = self.relay_issuer(server_url).await?;
        let body = self
            .post(&issuer, "/auth/v1/verification", json!({"email": email, "target": "ANY"}))
            .await?;
        let verification_id = body["verification_id"]
            .as_str()
            .ok_or("sign-in provider did not return a verification id")?
            .to_string();
        let pending = PendingSignIn {
            server_url: server_url.to_string(),
            issuer,
            email,
            verification_id,
            is_user: body["is_user"].as_bool().unwrap_or(false),
        };
        Ok((pending, body["expires_in"].as_u64().unwrap_or(600)))
    }

    pub async fn sign_in(
        &self,
        pending: &PendingSignIn,
        code: &str,
        now_ms: u64,
    ) -> Result<AccountSession, String> {
        let verified = self
            .post(
                &pending.issuer,
                "/auth/v1/verification/verify",
                json!({"verification_id": pending.verification_id, "verification_code": code.trim()}),
            )
            .await?;
        let verification_token = verified["verification_token"]
            .as_str()
            .ok_or("sign-in provider did not accept the code")?;
        // First-time addresses become accounts; known ones sign in.
        let path = if pending.is_user {
            "/auth/v1/signin"
        } else {
            "/auth/v1/signup"
        };
        let body = self
            .post(
                &pending.issuer,
                path,
                json!({"email": pending.email, "verification_token": verification_token}),
            )
            .await?;
        let tokens: TokenResponse = serde_json::from_value(body)
            .map_err(|_| "sign-in provider returned no tokens".to_string())?;
        let refresh_token = tokens
            .refresh_token
            .ok_or("sign-in provider returned no refresh token")?;
        let user_id = match tokens.sub {
            Some(sub) => sub,
            None => jwt_subject(&tokens.access_token).ok_or("access token has no subject")?,
        };
        let session = AccountSession {
            issuer: pending.issuer.clone(),
            email: pending.email.clone(),
            method: LoginMethod::Email,
            name: String::new(),
            picture: String::new(),
            user_id,
            access_token: tokens.access_token.clone(),
            refresh_token,
            expires_at: jwt_expires_at_ms(&tokens.access_token)
                .unwrap_or_else(|| now_ms + tokens.expires_in * 1000),
        };
        Ok(self.with_profile(session).await)
    }

    /// Standard OIDC refresh grant. Providers that rotate refresh tokens
    /// return a new one; otherwise the old one stays valid.
    pub async fn refresh(&self, session: &AccountSession, now_ms: u64) -> Result<AccountSession, String> {
        let body = self
            .post(
                &session.issuer,
                "/auth/v1/token",
                json!({"grant_type": "refresh_token", "refresh_token": session.refresh_token}),
            )
            .await
            .map_err(|error| format!("account session expired; sign in again ({error})"))?;
        let tokens: TokenResponse = serde_json::from_value(body)
            .map_err(|_| "sign-in provider returned no tokens".to_string())?;
        // Picks up a name or avatar set from another device.
        Ok(self
            .with_profile(AccountSession {
                access_token: tokens.access_token.clone(),
                refresh_token: tokens
                    .refresh_token
                    .unwrap_or_else(|| session.refresh_token.clone()),
                expires_at: jwt_expires_at_ms(&tokens.access_token)
                    .unwrap_or_else(|| now_ms + tokens.expires_in * 1000),
                ..session.clone()
            })
            .await)
    }

    /// Shows a PalmX QR. The challenge goes to PalmX; the verifier stays here
    /// until the relay redeems the confirmed code.
    pub async fn palmx_start(&self, server_url: &str) -> Result<PalmxPending, String> {
        let health = self.health(server_url).await?;
        let issuer = health["issuer"]
            .as_str()
            .map(|issuer| issuer.trim_end_matches('/').to_string())
            .filter(|issuer| trusted_issuer(issuer))
            .ok_or("the account relay has no sign-in provider configured")?;
        let method = parse_login_methods(&health)
            .into_iter()
            .find(|method| method.id == "palmx")
            .ok_or("this relay does not offer PalmX sign-in")?;
        let app_id = method.app_id.ok_or("the relay did not publish a PalmX app id")?;
        let base_url = method
            .base_url
            .filter(|url| trusted_issuer(url))
            .ok_or("the relay did not publish a PalmX address")?;
        let verifier = pkce_verifier();
        let state = format!("kode_{}", uuid::Uuid::new_v4().simple());
        let body = self
            .palmx_post(
                &base_url,
                "/palm/openai/x/oauth/qr/authorize",
                json!({"AppId": app_id, "CodeChallenge": pkce_challenge(&verifier), "CodeChallengeMethod": "S256", "State": state}),
            )
            .await?;
        let data = &body["data"];
        Ok(PalmxPending {
            server_url: server_url.to_string(),
            issuer,
            base_url,
            verifier,
            session_id: data["SessionId"].as_str().ok_or("PalmX returned no session")?.into(),
            qr_payload: data["QrcodePayload"].as_str().ok_or("PalmX returned no QR code")?.into(),
            expires_at: data["ExpiresAt"]
                .as_str()
                .and_then(|v| v.parse().ok())
                .or_else(|| data["ExpiresAt"].as_u64())
                .unwrap_or(0),
        })
    }

    pub async fn palmx_poll(&self, pending: &PalmxPending) -> Result<PalmxStatus, String> {
        let body = self
            .palmx_post(&pending.base_url, "/palm/openai/x/oauth/qr/poll", json!({"SessionId": pending.session_id}))
            .await?;
        Ok(match body["data"]["Status"].as_str().unwrap_or("pending") {
            "scanned" => PalmxStatus::Scanned,
            "confirmed" => PalmxStatus::Confirmed {
                code: body["data"]["Code"]
                    .as_str()
                    .ok_or("PalmX confirmed without a code")?
                    .to_string(),
            },
            "denied" => PalmxStatus::Denied,
            "expired" => PalmxStatus::Expired,
            _ => PalmxStatus::Pending,
        })
    }

    /// Redeems a confirmed code at the relay for CloudBase tokens.
    pub async fn palmx_sign_in(
        &self,
        pending: &PalmxPending,
        code: &str,
        now_ms: u64,
    ) -> Result<AccountSession, String> {
        let body = self
            .relay_call(
                reqwest::Method::POST,
                &pending.server_url,
                "/api/v1/auth/palmx",
                None,
                Some(json!({"code": code, "code_verifier": pending.verifier})),
            )
            .await?;
        let tokens: TokenResponse = serde_json::from_value(body)
            .map_err(|_| "the relay returned no tokens".to_string())?;
        let session = AccountSession {
            issuer: pending.issuer.clone(),
            email: String::new(),
            method: LoginMethod::Palmx,
            name: String::new(),
            picture: String::new(),
            user_id: match tokens.sub {
                Some(sub) => sub,
                None => jwt_subject(&tokens.access_token).ok_or("access token has no subject")?,
            },
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.ok_or("the relay returned no refresh token")?,
            expires_at: jwt_expires_at_ms(&tokens.access_token)
                .unwrap_or_else(|| now_ms + tokens.expires_in * 1000),
        };
        Ok(self.with_profile(session).await)
    }

    /// Copies the CloudBase profile (name, avatar, address) onto a session.
    /// Best effort: an unreachable profile keeps what the session had.
    pub async fn with_profile(&self, session: AccountSession) -> AccountSession {
        let profile: Option<Value> = async {
            self.with_device(self.http.get(format!("{}/auth/v1/user/me", session.issuer)))
                .bearer_auth(&session.access_token)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json()
                .await
                .ok()
        }
        .await;
        match profile {
            Some(profile) => apply_profile(session, &profile),
            None => session,
        }
    }

    /// Sets the account's display name on the CloudBase profile.
    pub async fn set_name(&self, session: &AccountSession, name: &str) -> Result<AccountSession, String> {
        let name = valid_name(name)?;
        let response = self
            .http
            .patch(format!("{}/auth/v1/user/profile", session.issuer))
            .bearer_auth(&session.access_token)
            .json(&json!({"name": name}))
            .send()
            .await
            .map_err(|error| format!("cannot reach the sign-in provider: {error}"))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if !status.is_success() {
            return Err(body["error_description"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("sign-in provider returned {status}")));
        }
        Ok(apply_profile(AccountSession { name: name.to_string(), ..session.clone() }, &body))
    }

    /// Exchanges a palm capture session (from this machine's camera) for
    /// the matched account's tokens.
    pub async fn palm_sign_in(&self, server_url: &str, session_id: &str, now_ms: u64) -> Result<AccountSession, String> {
        let issuer = self.relay_issuer(server_url).await?;
        let body = self
            .relay_call(
                reqwest::Method::POST,
                server_url,
                "/api/v1/auth/palm",
                None,
                Some(json!({"session_id": session_id})),
            )
            .await?;
        let tokens: TokenResponse = serde_json::from_value(body)
            .map_err(|_| "the relay returned no tokens".to_string())?;
        let session = AccountSession {
            issuer,
            email: String::new(),
            method: LoginMethod::Palm,
            name: String::new(),
            picture: String::new(),
            user_id: match tokens.sub {
                Some(sub) => sub,
                None => jwt_subject(&tokens.access_token).ok_or("access token has no subject")?,
            },
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.ok_or("the relay returned no refresh token")?,
            expires_at: jwt_expires_at_ms(&tokens.access_token)
                .unwrap_or_else(|| now_ms + tokens.expires_in * 1000),
        };
        Ok(self.with_profile(session).await)
    }

    /// Asks the relay for a handoff a phone can approve with a palm scan.
    pub async fn palm_handoff_start(&self, server_url: &str, now_ms: u64) -> Result<PalmHandoff, String> {
        let health = self.health(server_url).await?;
        let issuer = health["issuer"]
            .as_str()
            .map(|issuer| issuer.trim_end_matches('/').to_string())
            .filter(|issuer| trusted_issuer(issuer))
            .ok_or("the account relay has no sign-in provider configured")?;
        if !parse_login_methods(&health).iter().any(|method| method.id == "palm") {
            return Err("this relay does not offer palm sign-in".into());
        }
        let body = self
            .relay_call(reqwest::Method::POST, server_url, "/api/v1/auth/palm/handoff", None, None)
            .await?;
        let id = body["handoff_id"].as_str().ok_or("the relay returned no handoff")?.to_string();
        let secret = body["secret"].as_str().ok_or("the relay returned no handoff")?.to_string();
        let expires_in = body["expires_in"].as_u64().unwrap_or(120);
        Ok(PalmHandoff {
            qr_payload: palm_login_link(server_url, &id),
            server_url: server_url.to_string(),
            issuer,
            id,
            secret,
            expires_at: now_ms / 1000 + expires_in,
        })
    }

    /// `Ok(None)` while the phone has not approved yet.
    pub async fn palm_handoff_poll(
        &self,
        handoff: &PalmHandoff,
        now_ms: u64,
    ) -> Result<Option<AccountSession>, String> {
        let path = format!(
            "/api/v1/auth/palm/handoff/{}?secret={}",
            handoff.id,
            url_component(&handoff.secret)
        );
        let body = self
            .relay_call(reqwest::Method::GET, &handoff.server_url, &path, None, None)
            .await?;
        if body["state"] != "approved" {
            return Ok(None);
        }
        let tokens: TokenResponse = serde_json::from_value(body["tokens"].clone())
            .map_err(|_| "the relay returned no tokens".to_string())?;
        let session = AccountSession {
            issuer: handoff.issuer.clone(),
            email: String::new(),
            method: LoginMethod::Palm,
            name: String::new(),
            picture: String::new(),
            user_id: match tokens.sub {
                Some(sub) => sub,
                None => jwt_subject(&tokens.access_token).ok_or("access token has no subject")?,
            },
            access_token: tokens.access_token.clone(),
            refresh_token: tokens.refresh_token.ok_or("the relay returned no refresh token")?,
            expires_at: jwt_expires_at_ms(&tokens.access_token)
                .unwrap_or_else(|| now_ms + tokens.expires_in * 1000),
        };
        Ok(Some(self.with_profile(session).await))
    }

    /// Whether the account has a palm enrolled (enrolment happens on phones).
    pub async fn palm_enrolled(&self, server_url: &str, access_token: &str) -> Result<bool, String> {
        let body = self
            .relay_call(reqwest::Method::GET, server_url, "/api/v1/palm", Some(access_token), None)
            .await?;
        Ok(body["enrolled"] == true)
    }

    /// Links a confirmed palm to the signed-in account.
    pub async fn palmx_bind(&self, pending: &PalmxPending, code: &str, access_token: &str) -> Result<(), String> {
        self.relay_call(
            reqwest::Method::POST,
            &pending.server_url,
            "/api/v1/auth/palmx/bind",
            Some(access_token),
            Some(json!({"code": code, "code_verifier": pending.verifier})),
        )
        .await
        .map(|_| ())
    }

    pub async fn palmx_unbind(&self, server_url: &str, access_token: &str) -> Result<(), String> {
        self.relay_call(reqwest::Method::DELETE, server_url, "/api/v1/auth/palmx/bind", Some(access_token), None)
            .await
            .map(|_| ())
    }

    /// Sign-in methods linked to the account beyond the one that created it.
    pub async fn linked_methods(&self, server_url: &str, access_token: &str) -> Result<Vec<String>, String> {
        let body = self
            .relay_call(reqwest::Method::GET, server_url, "/api/v1/account/logins", Some(access_token), None)
            .await?;
        Ok(body["linked"]
            .as_array()
            .map(|ids| ids.iter().filter_map(|id| id.as_str().map(str::to_string)).collect())
            .unwrap_or_default())
    }

    async fn relay_call(
        &self,
        method: reqwest::Method,
        server_url: &str,
        path: &str,
        access_token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = self.with_device(self.http.request(method, format!("{server_url}{path}")));
        if let Some(token) = access_token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("cannot reach the account relay: {error}"))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        Err(body["detail"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| format!("account relay returned {status}")))
    }

    /// PalmX answers HTTP 200 with a business `code`; non-zero is an error.
    async fn palmx_post(&self, base_url: &str, path: &str, body: Value) -> Result<Value, String> {
        let body: Value = self
            .http
            .post(format!("{base_url}{path}"))
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("cannot reach PalmX: {error}"))?
            .json()
            .await
            .map_err(|_| "PalmX returned an unreadable response".to_string())?;
        if body["code"].as_i64() == Some(0) {
            Ok(body)
        } else {
            Err(format!(
                "PalmX: {}",
                body["message"].as_str().unwrap_or("request rejected")
            ))
        }
    }

    async fn post(&self, issuer: &str, path: &str, body: Value) -> Result<Value, String> {
        let response = self
            .with_device(self.http.post(format!("{issuer}{path}")))
            .json(&body)
            .send()
            .await
            .map_err(|error| format!("cannot reach the sign-in provider: {error}"))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        Err(body["error_description"]
            .as_str()
            .or_else(|| body["message"].as_str())
            .map(str::to_string)
            .unwrap_or_else(|| format!("sign-in provider returned {status}")))
    }
}

fn parse_login_methods(health: &Value) -> Vec<LoginMethodInfo> {
    match health["login_methods"].as_array() {
        Some(methods) => methods
            .iter()
            .filter_map(|method| serde_json::from_value(method.clone()).ok())
            .collect(),
        None => vec![LoginMethodInfo { id: "email".into(), app_id: None, base_url: None, sdk_url: None }],
    }
}

/// RFC 7636 verifier: 43 URL-safe characters from 32 random bytes.
/// CloudBase cannot clear profile fields (empty and null are ignored), so
/// blank values mean "unset".
fn apply_profile(mut session: AccountSession, profile: &Value) -> AccountSession {
    let field = |key: &str| profile[key].as_str().map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
    if let Some(name) = field("name") {
        session.name = name;
    }
    if let Some(picture) = field("picture").filter(|url| url.starts_with("https://")) {
        session.picture = picture;
    }
    if let Some(email) = field("email").filter(|_| session.email.is_empty()) {
        session.email = email;
    }
    session
}

/// Display names: 1-32 characters after trimming, no control characters.
pub fn valid_name(raw: &str) -> Result<&str, String> {
    let name = raw.trim();
    let count = name.chars().count();
    if count == 0 || count > 32 || name.chars().any(char::is_control) {
        return Err("enter a name of 1-32 characters".into());
    }
    Ok(name)
}

/// The QR a phone scans to approve a desktop's palm sign-in.
fn palm_login_link(server_url: &str, id: &str) -> String {
    format!("kode://palm-login?relay={}&id={}", url_component(server_url), url_component(id))
}

fn url_component(raw: &str) -> String {
    raw.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn pkce_verifier() -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    bytes.extend_from_slice(uuid::Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Sign-in codes and tokens travel to the issuer, so it must use TLS. Plain
/// HTTP is accepted only for loopback development servers.
fn trusted_issuer(issuer: &str) -> bool {
    match url::Url::parse(issuer) {
        Ok(url) if url.scheme() == "https" => url.host_str().is_some(),
        Ok(url) if url.scheme() == "http" => {
            matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
        }
        _ => false,
    }
}

/// Reads `sub` from a JWT payload without verifying it. Only used on tokens
/// just returned by the provider over TLS; the relay does the verification.
fn jwt_subject(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["sub"]
        .as_str()
        .map(str::to_string)
}

/// Extracts the `exp` claim from a JWT and returns it as epoch milliseconds.
/// Returns None if the token is malformed or has no `exp` claim.
fn jwt_expires_at_ms(token: &str) -> Option<u64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload.trim_end_matches('='))
        .ok()?;
    let exp_seconds = serde_json::from_slice::<Value>(&bytes).ok()?["exp"].as_u64()?;
    Some(exp_seconds * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_margin_triggers_before_expiry() {
        let session = AccountSession {
            issuer: "https://id.example.com".into(),
            email: "a@example.com".into(),
            method: LoginMethod::Email,
            name: String::new(),
            picture: String::new(),
            user_id: "u".into(),
            access_token: "a".into(),
            refresh_token: "r".into(),
            expires_at: 10 * 60 * 1000,
        };
        assert!(!session.needs_refresh(0));
        assert!(session.needs_refresh(6 * 60 * 1000));
    }

    #[test]
    fn sessions_saved_before_login_methods_read_as_email() {
        let session: AccountSession = serde_json::from_value(json!({
            "issuer": "https://id.example.com", "email": "a@example.com", "user_id": "u",
            "access_token": "a", "refresh_token": "r", "expires_at": 1
        }))
        .expect("legacy session");
        assert_eq!(session.method, LoginMethod::Email);
        assert_eq!(session.label(), "a@example.com");
        let palm = AccountSession { email: String::new(), method: LoginMethod::Palmx, user_id: "px_abcd1234".into(), ..session };
        assert_eq!(palm.label(), "Kode · 1234");
        let named = AccountSession { name: " Ada ".into(), ..palm };
        assert_eq!(named.label(), "Ada");
    }

    #[test]
    fn profiles_fill_blank_fields_only() {
        let session: AccountSession = serde_json::from_value(json!({
            "issuer": "https://id.example.com", "email": "a@example.com", "user_id": "u",
            "access_token": "a", "refresh_token": "r", "expires_at": 1
        }))
        .expect("session");
        let next = apply_profile(
            session.clone(),
            &json!({"name": "Ada", "picture": " ", "email": "other@example.com"}),
        );
        assert_eq!(next.name, "Ada");
        assert_eq!(next.picture, "");
        assert_eq!(next.email, "a@example.com");
        let pic = apply_profile(session, &json!({"picture": "http://x.example/a.png"}));
        assert_eq!(pic.picture, "", "plain-http avatars are dropped");
        assert!(valid_name("  ").is_err());
        assert!(valid_name(&"x".repeat(33)).is_err());
        assert_eq!(valid_name(" 王小明 ").unwrap(), "王小明");
    }

    #[test]
    fn login_methods_default_to_email_and_keep_relay_order() {
        assert_eq!(parse_login_methods(&json!({}))[0].id, "email");
        let methods = parse_login_methods(&json!({"login_methods": [
            {"id": "palm", "app_id": "app_1", "sdk_url": "https://palm.example.com/loader.js"},
            {"id": "email"},
            {"id": "future_method", "anything": true}
        ]}));
        let ids: Vec<&str> = methods.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["palm", "email", "future_method"]);
        assert_eq!(methods[0].app_id.as_deref(), Some("app_1"));
        assert_eq!(methods[0].sdk_url.as_deref(), Some("https://palm.example.com/loader.js"));
    }

    #[test]
    fn pkce_pairs_follow_rfc7636() {
        let verifier = pkce_verifier();
        assert_eq!(verifier.len(), 43);
        assert_ne!(verifier, pkce_verifier());
        // Expected value computed independently: Python
        // base64.urlsafe_b64encode(hashlib.sha256(v).digest()).rstrip(b"=").
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mJ92K9qp9k5lqb4HU4qGUh2TbWpJpM"),
            "T7RJai-YMOnH8syvZmhw1h4jJ1Vwl5kV6aTaIPtsr60"
        );
    }

    #[test]
    fn issuers_must_use_tls_except_on_loopback() {
        assert!(trusted_issuer("https://env.api.example.com"));
        assert!(trusted_issuer("http://127.0.0.1:9000"));
        assert!(!trusted_issuer("http://id.example.com"));
        assert!(!trusted_issuer("ftp://id.example.com"));
    }

    #[test]
    fn reads_subject_from_unverified_payload() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"user-42","exp":1}"#);
        assert_eq!(jwt_subject(&format!("h.{payload}.s")).as_deref(), Some("user-42"));
        assert_eq!(jwt_subject("garbage"), None);
    }

    #[test]
    fn reads_expiry_from_jwt_payload() {
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"user-42","exp":1794372658}"#);
        let token = format!("h.{payload}.s");
        assert_eq!(jwt_expires_at_ms(&token), Some(1794372658000));
        assert_eq!(jwt_expires_at_ms("garbage"), None);
        let no_exp = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"sub":"user-42"}"#);
        assert_eq!(jwt_expires_at_ms(&format!("h.{no_exp}.s")), None);
    }

    #[test]
    fn palm_login_links_escape_the_relay() {
        assert_eq!(
            palm_login_link("https://relay.example.com", "h1"),
            "kode://palm-login?relay=https%3A%2F%2Frelay.example.com&id=h1"
        );
    }

    #[tokio::test]
    async fn palm_handoff_releases_tokens_after_approval() {
        use axum::{
            extract::Query,
            routing::{get, post},
            Json, Router,
        };
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let approved = Arc::new(AtomicBool::new(false));
        let issuer = url.clone();
        let flag = approved.clone();
        let app = Router::new()
            .route(
                "/api/v1/healthz",
                get(move || {
                    let issuer = issuer.clone();
                    async move {
                        Json(json!({"server_kind": "kode-relay", "issuer": issuer,
                            "login_methods": [{"id": "palm", "app_id": "app_1"}, {"id": "email"}]}))
                    }
                }),
            )
            .route(
                "/api/v1/auth/palm/handoff",
                post(|| async { Json(json!({"handoff_id": "h1", "secret": "s/1", "expires_in": 120})) }),
            )
            .route(
                "/api/v1/auth/palm/handoff/h1",
                get(move |Query(q): Query<std::collections::HashMap<String, String>>| {
                    let flag = flag.clone();
                    async move {
                        assert_eq!(q.get("secret").map(String::as_str), Some("s/1"));
                        if flag.load(Ordering::SeqCst) {
                            Json(json!({"state": "approved", "tokens": {
                                "access_token": "a", "refresh_token": "r", "expires_in": 60, "sub": "123"}}))
                        } else {
                            Json(json!({"state": "pending"}))
                        }
                    }
                }),
            );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = AccountClient::default();
        let handoff = client.palm_handoff_start(&url, 1_000_000).await.expect("start");
        assert!(handoff.qr_payload.starts_with("kode://palm-login?relay=http%3A%2F%2F127.0.0.1"));
        assert_eq!(handoff.expires_at, 1_000 + 120);
        assert_eq!(client.palm_handoff_poll(&handoff, 0).await.expect("poll"), None);
        approved.store(true, Ordering::SeqCst);
        let session = client.palm_handoff_poll(&handoff, 0).await.expect("poll").expect("approved");
        assert_eq!(session.method, LoginMethod::Palm);
        assert_eq!(session.user_id, "123");
        assert_eq!(session.label(), "Kode · 123");
    }
}
