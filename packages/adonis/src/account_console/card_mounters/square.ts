/**
 * Browser mounter for Square: the Web Payments SDK card form, tokenized in the browser into a
 * single-use nonce that goes to `saveCard`.
 */
export const squareMounter = String.raw`mounters['square'] = async function (c) {
  var labels = c.props.labels || {};
  var Square = await c.global('Square');
  var payments = Square.payments(c.props.applicationId, c.props.locationId);
  var card = await payments.card();
  await card.attach(c.container);
  c.onSave(async function () {
    var result = await card.tokenize();
    if (result && result.status === 'OK' && typeof result.token === 'string') return result.token;
    var message = result && result.errors && result.errors[0] && result.errors[0].message;
    throw new Error(message || labels.failed);
  });
};`;
