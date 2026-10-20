/**
 * Dismisses the boot screen in index.html. It stays up for a minimum time so a fast load does not
 * flash, shows the outcome briefly, then fades out and is removed. Safe to call more than once.
 */
const MIN_VISIBLE_MS = 1400   // from navigation start; the intro animation finishes around 1.2s
const OUTCOME_MS = 320        // bar fills and status reads "Ready" before the fade
const FADE_MS = 420           // matches the .boot transition in index.html
const SLOW_MS = 5000          // say so when the backend is slow to answer
const HANDOFF_MS = 10000      // then let the app's own loading states take over

let finishing = false

function setStatus(text: string) {
  const label = document.getElementById('boot-status')
  if (label) label.textContent = text
}

export function finishBoot(status = 'Ready') {
  if (finishing) return
  finishing = true
  window.clearTimeout(slowTimer)
  window.clearTimeout(handoffTimer)
  const boot = document.getElementById('boot')
  if (!boot) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const wait = reduced ? 0 : Math.max(0, MIN_VISIBLE_MS - performance.now())
  window.setTimeout(() => {
    setStatus(status)
    boot.classList.add('is-done')
    window.setTimeout(() => {
      boot.classList.add('is-leaving')
      boot.setAttribute('aria-hidden', 'true')
      window.setTimeout(() => boot.remove(), FADE_MS + 50)
    }, reduced ? 0 : OUTCOME_MS)
  }, wait)
}

const slowTimer = window.setTimeout(() => setStatus('Still loading cases…'), SLOW_MS)
const handoffTimer = window.setTimeout(() => finishBoot('Opening workstation'), HANDOFF_MS)
