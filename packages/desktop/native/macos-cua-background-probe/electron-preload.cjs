'use strict';

// The isolated preload observes only the fixed fixture's controls. It exposes no
// capability to the page and sends only the resulting fixture-owned state.
const { ipcRenderer } = require('electron');
window.addEventListener('DOMContentLoaded', () => {
  const button = document.querySelector('button');
  const field = document.querySelector('input');
  if (!button || !field) throw new Error('fixture controls missing');
  button.addEventListener('click', () => ipcRenderer.send('probe-effect', 'click'));
  const report = (event) => ipcRenderer.send('probe-effect', 'value', event.target.value);
  field.addEventListener('input', report);
  field.addEventListener('change', report);
});
