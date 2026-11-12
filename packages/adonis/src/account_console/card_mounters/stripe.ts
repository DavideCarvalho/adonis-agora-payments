/** Stripe: the Payment Element, confirming the SetupIntent the page created. */
export const stripeMounter = String.raw`mounters['stripe'] = async function (c) {
  var StripeCtor = await c.global('Stripe');
  var stripe = StripeCtor(c.props.publishableKey);
  var elements = stripe.elements({ clientSecret: c.props.clientSecret });
  var element = elements.create('payment', { paymentMethodOrder: ['card'] });
  element.mount(c.container);
  c.onSave(async function () {
    var result = await stripe.confirmSetup({ elements: elements, redirect: 'if_required' });
    if (result.error) throw new Error(result.error.message || c.props.labels.failed);
    if (!result.setupIntent || result.setupIntent.status !== 'succeeded') {
      throw new Error(c.props.labels.failed);
    }
    return result.setupIntent.id;
  });
};`;
