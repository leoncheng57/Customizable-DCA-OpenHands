// Browser-sound notification channel: a WebAudio chime played when a
// conversation transitions into a state that needs attention. Preferences
// (on/off, volume, per-event filter) live in notify.ts — independent of the
// server-side ntfy channel, so users can enable one, both, or neither.
//
// No audio asset: the chime is synthesized (two sine tones), which keeps the
// bundle clean and works offline. Browsers gate audio behind a user gesture;
// the shared AudioContext unlocks on the first click anywhere in the app.

let ctx: AudioContext | null = null;

function audioContext(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(ac: AudioContext, freq: number, start: number, duration: number, gainPeak: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(gainPeak, start + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration + 0.05);
}

/**
 * Play the notification chime. "ok" is a rising two-tone (finished/awaiting
 * input); "error" a falling minor pair (error/stuck). `volume` is 0..1 and
 * scales the previous fixed peak (0.08) up to ~2x at full volume.
 */
export function playChime(kind: "ok" | "error" = "ok", volume = 0.6): void {
  const ac = audioContext();
  if (!ac || volume <= 0) return;
  const gainPeak = 0.16 * Math.min(1, Math.max(0, volume));
  const t = ac.currentTime;
  if (kind === "ok") {
    tone(ac, 660, t, 0.18, gainPeak);
    tone(ac, 880, t + 0.12, 0.25, gainPeak);
  } else {
    tone(ac, 440, t, 0.2, gainPeak);
    tone(ac, 330, t + 0.14, 0.3, gainPeak);
  }
}
