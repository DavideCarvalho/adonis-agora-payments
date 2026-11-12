/**
 * Browser mounter for PayPal: the JS SDK's buttons approve the vault setup token `cardSetup`
 * created, and the approved setup token goes to `saveCard`. PayPal draws its own button, so
 * the console's "Save card" button is hidden.
 */
export const paypalMounter = String.raw`mounters['paypal'] = async function (c) {
  var labels = c.props.labels || {};
  c.hideSave();
  var paypal = await c.global('paypal');
  await paypal.Buttons({
    createVaultSetupToken: function () { return c.props.setupToken; },
    onApprove: function (data) { return c.submit(data.vaultSetupToken); },
    onError: function () { c.fail(labels.failed); }
  }).render(c.container);
};`;
