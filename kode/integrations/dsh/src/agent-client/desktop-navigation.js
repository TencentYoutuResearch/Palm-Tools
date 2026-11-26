  // Embedded in Kode desktop (kode.extension/v1 view): Kode hides its own
  // chrome, so the way back to its terminals ("Kode 终端") lives in dsh's UI.
  const kodeEmbedded = () => !!globalThis.document?.documentElement?.hasAttribute?.('data-kode-embed') && typeof globalThis.window?.kodeHost?.request === 'function'
  const glyph = (d, size = 15) => h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d }))
  const TERMINAL_GLYPH = 'M2.5 3.5h11v9h-11zM5 6.5l2 1.5-2 1.5M8.5 10h2.5'
  // The supplied KODE. wordmark, split into transparent layers: white strokes follow the
  // theme ink through a mask, red strokes keep the brand colour. Shared by sidebar and hero.
  const BRAND_LAYER = layer => `/api/kode/avatars/media?type=brand-${layer}&state=idle`
  function KodeBrandMark({ size = 24, height = Math.round(size * 280 / 312), className = '' }) {
    return h('span', {
      className: `kode-brand-mark ${className}`.trim(), 'aria-hidden': true,
      style: { width: Math.round(height * 681 / 280), height, '--kode-brand-ink': `url("${BRAND_LAYER('ink')}")` },
    },
    h('span', { className: 'kode-brand-ink' }),
    h('img', { src: BRAND_LAYER('red'), alt: '', draggable: false }))
  }
  // The sidebar slot offers a 24px seat sized for dsh's own wordmark; Kode's mark and name
  // scale up to fill the row up to the collapse toggle (see .kode-brand-name).
  function SidebarBrandMark() { return h(KodeBrandMark, { height: 26, className: 'kode-sidebar-brand-mark' }) }
  // dsh draws its inverted Harness badge only inside BrandWordmark. Keep exactly that plate and
  // its glyphs (with their theme fills), drop the deepseek letters and whale outright, and frame
  // the viewBox on the plate; the text fallback covers primitives without the badge.
  const HARNESS_BADGE_HEIGHT = 20
  function nativeHarnessBadge() {
    if (typeof BrandWordmark !== 'function') return null
    try {
      const svg = BrandWordmark({ includeMark: false })
      const parts = React.Children.toArray(svg?.props?.children)
      const plate = parts.find(part => part?.type === 'rect')
      const glyphs = parts.find(part => part?.type === 'g' && /badge/.test(part.props?.clipPath ?? ''))
      const defs = parts.find(part => part?.type === 'defs')
      const [x, y, width, height] = ['x', 'y', 'width', 'height'].map(key => Number(plate?.props?.[key]))
      if (!glyphs || ![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null
      return React.cloneElement(svg, {
        className: 'kode-harness-badge', viewBox: `${x} ${y} ${width} ${height}`,
        width: Math.round(HARNESS_BADGE_HEIGHT * width / height * 10) / 10, height: HARNESS_BADGE_HEIGHT,
      }, plate, glyphs, defs)
    } catch { return null }
  }
  function KodeBrandName() {
    const badge = nativeHarnessBadge()
    return badge
      ? h('span', { className: 'kode-brand-name kode-brand-name-badge', role: 'img', 'aria-label': 'Harness' }, badge)
      : h('span', { className: 'kode-brand-name' }, 'Harness')
  }
  // The view is only hidden after leaving, so the panel would still be open on
  // the next entry and send Kode straight back; return to the conversation once
  // Kode has had time to hide the view.
  const RESUME_PROFILE_KEY = 'kode.resumeProfile'
  const HISTORY_GLYPH = 'M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.6 2.6v2.6h2.6M8 5.2V8l2 1.4'
  // Closed conversations come back through resume, as in Kode's terminals.
  function KodeResumePage({ layout }) {
    useEffect(() => {
      window.dispatchEvent(new CustomEvent('kode-resume-session', { detail: { global: true, hostId: transport?.current ?? 'local' } }))
      layout?.selectPanel(null)
    }, [])
    return null
  }
