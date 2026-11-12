import { asaasMounter } from './card_mounters/asaas.js';
import { mercadopagoMounter } from './card_mounters/mercadopago.js';
import { pagarmeMounter } from './card_mounters/pagarme.js';
import { paypalMounter } from './card_mounters/paypal.js';
import { squareMounter } from './card_mounters/square.js';
import { stripeMounter } from './card_mounters/stripe.js';

/** The per-gateway mounters, each one statement assigning `mounters['<gateway>']`. */
const MOUNTERS = [
  stripeMounter,
  asaasMounter,
  pagarmeMounter,
  mercadopagoMounter,
  squareMounter,
  paypalMounter,
];

/**
 * The account console's card form: a same-origin script authkit loads (with the page's CSP nonce)
 * for the `payments-card` component block. It mounts the gateway's own component (Stripe's Payment
 * Element, Square's card, PayPal's button…) into the block, and once the gateway hands back a
 * token, submits the block's form with it so the account console runs `saveCard`. Without
 * JavaScript, or when the gateway's script cannot load, the block's fallback link stays.
 */
export const CARD_SCRIPT = `(() => {
  'use strict';
  var mounters = {};
${MOUNTERS.join('\n')}
  function global(name) {
    return new Promise(function (resolve, reject) {
      var waited = 0;
      (function poll() {
        if (window[name]) return resolve(window[name]);
        waited += 50;
        if (waited > 15000) return reject(new Error(name + ' did not load'));
        setTimeout(poll, 50);
      })();
    });
  }
  var blocks = document.querySelectorAll('[data-block="component"][data-provider="payments-card"]');
  Array.prototype.forEach.call(blocks, function (mount) {
    if (mount.getAttribute('data-mounted') === '1') return;
    mount.setAttribute('data-mounted', '1');
    var props;
    try {
      props = JSON.parse(document.getElementById(mount.getAttribute('data-props')).textContent);
    } catch (e) {
      return;
    }
    var mounter = mounters[props.gateway];
    var form = mount.querySelector('form[data-component-form]');
    if (!mounter || !form) return;
    var labels = props.labels || {};
    var fallback = mount.querySelector('[data-component-fallback]');
    var container = document.createElement('div');
    container.className = 'space-y-3';
    var status = document.createElement('p');
    status.className = 'mt-2 text-sm text-red-700';
    status.setAttribute('role', 'alert');
    var button = document.createElement('button');
    button.type = 'button';
    button.hidden = true;
    button.className = 'mt-3 rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white';
    button.textContent = labels.save || 'Save card';
    mount.appendChild(container);
    mount.appendChild(button);
    mount.appendChild(status);
    var csrfInput = form.querySelector('input[name="_csrf"]');
    function submit(token) {
      var target = form.querySelector('input[name="target"]');
      if (!target) {
        target = document.createElement('input');
        target.type = 'hidden';
        target.name = 'target';
        form.appendChild(target);
      }
      target.value = props.target + '~' + token;
      form.submit();
    }
    function failWith(message) {
      status.textContent = message || labels.failed || 'Failed.';
      button.disabled = false;
      button.textContent = labels.save || 'Save card';
    }
    var c = {
      props: props,
      container: container,
      csrf: csrfInput ? csrfInput.value : null,
      global: global,
      submit: submit,
      fail: failWith,
      hideSave: function () { button.hidden = true; },
      onSave: function (fn) {
        button.hidden = false;
        button.onclick = async function () {
          status.textContent = '';
          button.disabled = true;
          button.textContent = labels.saving || 'Saving…';
          try {
            submit(await fn());
          } catch (error) {
            failWith(error && error.message);
          }
        };
      },
      input: function (name, label, attrs) {
        var wrap = document.createElement('label');
        wrap.className = 'block text-sm text-gray-700';
        var caption = document.createElement('span');
        caption.textContent = label;
        var input = document.createElement('input');
        input.name = 'card_' + name;
        input.className = 'mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm';
        Object.keys(attrs || {}).forEach(function (key) {
          if (key === 'value') input.value = attrs[key];
          else input.setAttribute(key, attrs[key]);
        });
        wrap.appendChild(caption);
        wrap.appendChild(input);
        container.appendChild(wrap);
        return input;
      }
    };
    Promise.resolve()
      .then(function () { return mounter(c); })
      .then(function () { if (fallback) fallback.hidden = true; })
      .catch(function (error) {
        container.textContent = '';
        button.hidden = true;
        failWith(error && error.message);
      });
  });
})();
`;
