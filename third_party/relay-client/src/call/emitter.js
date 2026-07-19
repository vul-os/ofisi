// emitter.js — minimal event emitter shared across call modules.
//
// Provides on/off/emit semantics (EventTarget-ish but lighter weight).
// Used by rtc.js (the Call class extends it) and fabricSignaling.js
// (the BroadcastChannel stub session exposes the same surface).

export class Emitter {
  constructor() { this._h = {} }
  on(ev, cb) { (this._h[ev] = this._h[ev] || []).push(cb); return () => this.off(ev, cb) }
  off(ev, cb) { this._h[ev] = (this._h[ev] || []).filter(f => f !== cb) }
  emit(ev, ...a) { (this._h[ev] || []).forEach(f => { try { f(...a) } catch (e) { console.error(e) } }) }
}
