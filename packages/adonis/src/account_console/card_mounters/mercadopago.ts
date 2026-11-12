/**
 * Browser mounter for Mercado Pago: Secure Fields (SDK v2) for the card number, expiry and CVV,
 * plus the console's own inputs for the holder name and CPF. The card token goes to `saveCard`.
 */
export const mercadopagoMounter = String.raw`mounters['mercadopago'] = async function (c) {
  var labels = c.props.labels || {};
  var MercadoPago = await c.global('MercadoPago');
  var mp = new MercadoPago(c.props.publicKey);
  function slot(name, label) {
    var input = c.input(name, label, {});
    var div = document.createElement('div');
    div.id = 'mp-card-' + name;
    div.className = input.className;
    div.style.height = '40px';
    input.parentNode.replaceChild(div, input);
    return div.id;
  }
  mp.fields.create('cardNumber', {}).mount(slot('number', labels.number));
  var holder = c.input('holder', labels.holder, { autocomplete: 'cc-name' });
  mp.fields.create('expirationDate', { placeholder: 'MM/YY' }).mount(slot('expiry', labels.expiry));
  mp.fields.create('securityCode', {}).mount(slot('cvc', labels.cvc));
  var document_ = c.input('document', labels.document || 'CPF', { inputmode: 'numeric' });
  c.onSave(async function () {
    var token = await mp.fields.createCardToken({
      cardholderName: String(holder.value).trim(),
      identificationType: 'CPF',
      identificationNumber: String(document_.value).replace(/\D/g, '')
    });
    if (!token || typeof token.id !== 'string') throw new Error(labels.failed);
    return token.id;
  });
};`;
