'use strict';

module.exports = {
  // GET /api/app/com.sgsmart.csrmesh/log-view, for "Show log" on the settings
  // page: a short summary and the latest lines of the app's log, with
  // Bluetooth addresses, UUIDs and device names hidden (see app.logView).
  async getLogView({ homey }) {
    try {
      return await homey.app.logView();
    } catch (err) {
      return { error: String((err && err.message) || err) };
    }
  },

  // The SG account on the settings page (lib/account.js): GET /account
  // gives the summary, POST /account/login logs in with { email, password }
  // and fetches, POST /account/forget removes what was kept. The e-mail and
  // password are only handed on, never kept or logged here; an error gives
  // its kind, never its text.
  async getAccount({ homey }) {
    try {
      return homey.app.account.summary();
    } catch (err) {
      return { error: 'other' };
    }
  },

  async loginAccount({ homey, body }) {
    try {
      const { email, password } = body || {};
      return await homey.app.account.login(email, password);
    } catch (err) {
      return { error: 'other' };
    }
  },

  async forgetAccount({ homey }) {
    try {
      return homey.app.account.forget();
    } catch (err) {
      return { error: 'other' };
    }
  },
};
