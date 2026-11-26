// Lightning invoices and Lightning Addresses, as far as the skill needs to understand them.

import { SkillError } from './errors.mjs';

const LOOKUP_TIMEOUT_MS = 20_000;
const MSAT_PER_UNIT = {'': 100_000_000_000n, m: 100_000_000n, u: 100_000n, n: 100n};

/**
 * The amount a mainnet BOLT11 invoice asks for, in millisatoshis, read from its prefix (lnbc20n... is 20
 * nano-bitcoin, which is 2 sats). Null when it names no amount. Throws for anything but a mainnet invoice.
 */
export function invoiceAmountMsat(invoice) {
  const text = String(invoice || '').trim().toLowerCase();
  const separator = text.lastIndexOf('1'); // The prefix ends at the last '1'; the rest never contains one
  const match = separator > 0 && /^lnbc(?:(\d+)([munp]?))?$/.exec(text.slice(0, separator));
  if (!match) {
    throw new SkillError('INVALID_INVOICE', 'Not a mainnet Lightning invoice (it should start with lnbc)');
  }
  const [, digits, unit] = match;
  if (digits === undefined) {
    return null;
  }
  const amount = BigInt(digits);
  if (unit === 'p') {
    // Pico-bitcoin: ten to the millisatoshi
    if (amount % 10n !== 0n) {
      throw new SkillError('INVALID_INVOICE', 'The invoice amount is smaller than one millisatoshi');
    }
    return amount / 10n;
  }
  return amount * MSAT_PER_UNIT[unit];
}

/** A whole number of sats from what was typed. */
export function parseSats(text) {
  if (!/^[1-9]\d{0,11}$/.test(String(text || ''))) {
    throw new SkillError('INVALID_AMOUNT', 'The amount is a whole number of sats, at least 1');
  }
  return Number(text);
}

/** Where a Lightning Address (name@domain) answers with how to pay it. */
export function lightningAddressUrl(address) {
  const match = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(String(address || '').trim().toLowerCase());
  if (!match) {
    throw new SkillError('INVALID_ADDRESS', 'A Lightning Address looks like name@domain');
  }
  const [, name, domain] = match;
  return `https://${domain}/.well-known/lnurlp/${name}`;
}

async function getJson(url) {
  const host = new URL(url).hostname;
  let response;
  try {
    response = await fetch(url, {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)});
  } catch {
    throw new SkillError('ADDRESS_UNREACHABLE', `Could not reach ${host}`);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.status === 'ERROR') {
    throw new SkillError('ADDRESS_REFUSED', String(body?.reason || `${host} answered ${response.status}`).slice(0, 200));
  }
  return body;
}

/**
 * Asks a Lightning Address for an invoice of exactly this many sats. The payee's server chooses what to send
 * back, so the invoice is checked to be for the amount asked before it goes anywhere near the owner.
 */
export async function invoiceFromAddress(address, sats) {
  const payee = await getJson(lightningAddressUrl(address));
  if (payee.tag !== 'payRequest' || typeof payee.callback !== 'string' || !payee.callback.startsWith('https://')) {
    throw new SkillError('ADDRESS_REFUSED', 'That address does not accept Lightning payments');
  }

  const msat = sats * 1000;
  const min = Number(payee.minSendable);
  const max = Number(payee.maxSendable);
  if (msat < min || msat > max) {
    throw new SkillError('AMOUNT_OUT_OF_RANGE', `That address accepts ${Math.ceil(min / 1000)} to ${Math.floor(max / 1000)} sats`);
  }

  const callback = new URL(payee.callback);
  // The invoice is fetched from the callback, so whoever runs the callback decides who gets paid.
  // If it is not the address's own host, the typed address proves nothing about the payee; refuse it.
  // (A provider that legitimately splits the two hosts can relax this, e.g. by checking the invoice's
  // description_hash against the payee document's metadata.)
  const payeeHost = new URL(lightningAddressUrl(address)).hostname;
  if (callback.hostname !== payeeHost) {
    throw new SkillError('ADDRESS_REFUSED',
      `The address points its callback at ${callback.hostname}, so the invoice would pay a different server`);
  }
  callback.searchParams.set('amount', String(msat));
  const invoice = (await getJson(callback.toString())).pr;
  if (typeof invoice !== 'string' || invoiceAmountMsat(invoice) !== BigInt(msat)) {
    throw new SkillError('ADDRESS_REFUSED', 'The payee returned an invoice for a different amount, so it was not sent to the owner');
  }
  return invoice;
}
