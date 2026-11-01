'use strict';

const SGCsrDevice = require('../../lib/SGCsrDevice');

// Smart Plug and Smart Socket: on and off as any device without dimming
// (lib/SGCsrDevice.js), and a countdown that Homey counts itself. When it is
// up, one FF03 off goes to the plug, whatever its last status said: Homey may
// not have heard it since. Turning the plug off in Homey cancels the
// countdown. The plug's own countdown is not used, so nothing in the plug is
// set but on and off. The end time is kept in the store, so the countdown
// goes on after a restart, never longer than COUNTDOWN_MAX_MIN from then; one
// that ran out while the app was not running is only logged, and nothing is
// sent.

// The longest countdown, as the Flow cards allow it: a day.
const COUNTDOWN_MAX_MIN = 1440;

const clock = (at) => new Date(at).toISOString().slice(11, 16);

class SGPlugDevice extends SGCsrDevice {
  async onInit() {
    await super.onInit();
    if (!this._net()) return; // a fake device without its network (lib/SGCsrDevice.js)
    this._countdownTimer = null;
    this._resumeCountdown();
  }

  async onDeleted() {
    this._clearCountdownTimer();
    await super.onDeleted();
  }

  async onUninit() {
    this._clearCountdownTimer();
    await super.onUninit();
  }

  // "Turn off in ... minutes": a new countdown replaces the one running.
  async offIn(minutes) {
    const whole = Math.max(1, Math.min(COUNTDOWN_MAX_MIN, Math.round(Number(minutes) || 0)));
    const at = Date.now() + whole * 60 * 1000;
    await this.setStoreValue('countdown', { at, minutes: whole });
    this._scheduleCountdown(at);
    this.log(`countdown: off in ${whole} min, at ${clock(at)} UTC`);
    return true;
  }

  // "Turn on for ... minutes": on now, and the countdown to off.
  async onFor(minutes) {
    this._request(100);
    return this.offIn(minutes);
  }

  // "Cancel the countdown": nothing is sent.
  async cancelCountdown() {
    const running = this.countdownRunning();
    this._clearCountdownTimer();
    await this.setStoreValue('countdown', null);
    this.log(running ? 'countdown cancelled' : 'countdown cancel: none was running');
    return true;
  }

  // FF05 from a plug is assumed to carry the plug's own countdown in bytes 7
  // and 8: minutes, and whether it runs (not tried). It is only logged, when
  // it changes; the countdown that counts here is Homey's.
  applyCsrStatus(status, kind) {
    const applied = super.applyCsrStatus(status, kind);
    if (applied && kind === 'FF05' && Number.isInteger(status.white) && Number.isInteger(status.flags)) {
      const own = `${status.white} min, ${status.flags ? 'running' : 'not running'}`;
      if (own !== this._ownCountdown) {
        this._ownCountdown = own;
        this.log(`the plug's own countdown in FF05: ${own} (assumed meaning)`);
      }
    }
    return applied;
  }

  // Off chosen in Homey cancels a running countdown; on does not.
  _userLevel(level) {
    if (level === 0 && this.countdownRunning()) {
      this._clearCountdownTimer();
      this.setStoreValue('countdown', null).catch((err) => this.error(`clearing the countdown failed: ${err.message || err}`));
      this.log('countdown cancelled: turned off in Homey');
    }
    super._userLevel(level);
  }

  countdownRunning() {
    const countdown = this.getStoreValue('countdown');
    return !!(countdown && countdown.at > Date.now() && this._countdownTimer);
  }

  _scheduleCountdown(at) {
    this._clearCountdownTimer();
    this._countdownTimer = this.homey.setTimeout(() => {
      this._countdownTimer = null;
      this._countdownDone().catch((err) => this.error(`countdown failed: ${err.message || err}`));
    }, Math.max(0, at - Date.now()));
  }

  _clearCountdownTimer() {
    if (this._countdownTimer) this.homey.clearTimeout(this._countdownTimer);
    this._countdownTimer = null;
  }

  async _countdownDone() {
    await this.setStoreValue('countdown', null);
    this.log('countdown done: off');
    this._request(0);
    await this.homey.flow.getDeviceTriggerCard('plug_countdown_done').trigger(this, {}, {})
      .catch((err) => this.error(`countdown done card failed: ${err.message || err}`));
  }

  // A countdown from before the restart: on with what is left, at most
  // COUNTDOWN_MAX_MIN (a clock that was wrong could make it longer), or, when
  // it ran out meanwhile, only logged.
  _resumeCountdown() {
    const countdown = this.getStoreValue('countdown');
    if (!countdown || !Number.isFinite(countdown.at)) return;
    const left = countdown.at - Date.now();
    if (left > 0) {
      const latest = Date.now() + COUNTDOWN_MAX_MIN * 60 * 1000;
      const at = Math.min(countdown.at, latest);
      if (at !== countdown.at) {
        this.setStoreValue('countdown', { ...countdown, at }).catch((err) => this.error(`storing the countdown failed: ${err.message || err}`));
      }
      this._scheduleCountdown(at);
      this.log(`countdown goes on: off at ${clock(at)} UTC, ${Math.ceil((at - Date.now()) / 60000)} min left`
        + `${at !== countdown.at ? `, cut to ${COUNTDOWN_MAX_MIN} min` : ''}`);
      return;
    }
    this.log(`countdown ran out ${Math.round(-left / 60000)} min ago while the app was not running: nothing sent`);
    this.setStoreValue('countdown', null).catch((err) => this.error(`clearing the countdown failed: ${err.message || err}`));
  }
}

module.exports = SGPlugDevice;
