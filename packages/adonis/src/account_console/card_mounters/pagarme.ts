/**
 * Browser mounter for Pagar.me: the console's own card fields, tokenized straight with Pagar.me
 * (`POST /core/v5/tokens?appId=<publicKey>`), so the card never reaches the server. The token
 * (`token_…`) goes to `saveCard`.
 */
export const pagarmeMounter = String.raw`mounters['pagarme'] = async function (c) {
  var labels = c.props.labels || {};
  var number = c.input('number', labels.number, { autocomplete: 'cc-number', inputmode: 'numeric' });
  var holder = c.input('holder', labels.holder, { autocomplete: 'cc-name' });
  var expiry = c.input('expiry', labels.expiry, { autocomplete: 'cc-exp', placeholder: 'MM/YY', inputmode: 'numeric' });
  var cvc = c.input('cvc', labels.cvc, { autocomplete: 'cc-csc', inputmode: 'numeric' });
  c.onSave(async function () {
    var parts = String(expiry.value).replace(/\s/g, '').split('/');
    var month = parseInt(parts[0], 10);
    var year = parseInt(parts[1], 10);
    if (!(month >= 1 && month <= 12) || !(year >= 0)) throw new Error(labels.failed);
    if (year < 100) year += 2000;
    var response = await fetch('https://api.pagar.me/core/v5/tokens?appId=' + encodeURIComponent(c.props.publicKey), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'card',
        card: {
          number: String(number.value).replace(/\D/g, ''),
          holder_name: String(holder.value).trim(),
          exp_month: month,
          exp_year: year,
          cvv: String(cvc.value).replace(/\D/g, '')
        }
      })
    });
    var data = null;
    try { data = await response.json(); } catch (e) { data = null; }
    if (!response.ok || !data || typeof data.id !== 'string') {
      throw new Error((data && data.message) || labels.failed);
    }
    return data.id;
  });
};`;
