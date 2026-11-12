/**
 * Asaas: tokenizes on the server only, so the form sends the card to this app's tokenize endpoint
 * (under the page's ticket) and submits the sealed token it gets back.
 */
export const asaasMounter = String.raw`mounters['asaas'] = async function (c) {
  var l = c.props.labels;
  var holder = c.props.holder || {};
  var number = c.input('number', l.number, { autocomplete: 'cc-number', inputmode: 'numeric' });
  var name = c.input('holderName', l.holder, { autocomplete: 'cc-name', value: holder.name || '' });
  var expiry = c.input('expiry', l.expiry, { autocomplete: 'cc-exp', placeholder: 'MM/YY' });
  var cvc = c.input('cvc', l.cvc, { autocomplete: 'cc-csc', inputmode: 'numeric' });
  var doc = c.input('cpfCnpj', l.document, { inputmode: 'numeric' });
  var postal = c.input('postalCode', l.postalCode, { autocomplete: 'postal-code' });
  var addressNumber = c.input('addressNumber', l.addressNumber, {});
  var phone = c.input('phone', l.phone, { autocomplete: 'tel', inputmode: 'tel' });
  c.onSave(async function () {
    var headers = { 'content-type': 'application/json', accept: 'application/json', 'x-payments-card-ticket': c.props.ticket };
    if (c.props.sameOrigin && c.csrf) headers['x-csrf-token'] = c.csrf;
    var res = await fetch(c.props.tokenizeUrl, {
      method: 'POST',
      headers: headers,
      credentials: c.props.sameOrigin ? 'same-origin' : 'omit',
      body: JSON.stringify({
        number: number.value,
        holderName: name.value,
        expiry: expiry.value,
        cvc: cvc.value,
        holder: {
          name: name.value,
          email: holder.email || '',
          cpfCnpj: doc.value,
          postalCode: postal.value,
          addressNumber: addressNumber.value,
          phone: phone.value
        }
      })
    });
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok || !body.token) throw new Error(l.failed);
    number.value = '';
    cvc.value = '';
    return body.token;
  });
};`;
