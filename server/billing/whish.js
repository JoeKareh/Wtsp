// WhishPayBilling: STUB behind a feature flag (WHISH_PAY_ENABLED=true). The interface is implemented so the rest of the system can route to it;
// every operation fails with a clear message until a Whish merchant account and API are available. See docs/WHISH_PAY.md for what must be confirmed first.
import { HttpError } from '../util.js';
const off = () => { throw new HttpError(501, 'Whish Pay is not connected. Until it is, Lebanese customers pay through ManualBilling (bank transfer / Whish Money transfer / OMT).'); };
export const whish = {
  name: 'whish', enabled: () => process.env.WHISH_PAY_ENABLED === 'true',
  createCheckout: off, handleWebhook: off, customerPortalUrl: off, cancel: off, changePlan: off, syncStatus: off,
};
