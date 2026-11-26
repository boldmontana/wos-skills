// Lightning invoices and Lightning Addresses, as far as the skill needs to understand them.

import { createHash } from 'node:crypto';

import { SkillError } from './errors.mjs';

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/**
 * The description hash (BOLT11 field tag 23) an invoice carries, as hex, or null when it has none.
 * Only the field is parsed; signature and checksum are not validated here.
 */
export function invoiceDescriptionHash(invoice) {
  const text = String(invoice || '').toLowerCase();
  const separator = text.lastIndexOf('1');
  if (separator < 1) return null;
  const data = [...text.slice(separator + 1)].map(ch => BECH32.indexOf(ch));
  if (data.includes(-1)) return null;
  const words = data.slice(0, -6); // trailing 6 words are the checksum
  let i = 7; // 35-bit timestamp
  while (i + 3 <= words.length) {
    const tag = words[i];
    const length = words[i + 1] * 32 + words[i + 2];
    i += 3;
    const value = words.slice(i, i + length);
    i += length;
    if (tag === 23 && length === 52) {
      let bits = '';
      for (const word of value) bits += word.toString(2).padStart(5, '0');
      let hex = '';
      for (let b = 0; b < 32; b += 1) hex += parseInt(bits.slice(b * 8, b * 8 + 8), 2).toString(16).padStart(2, '0');
      return hex;
    }
  }
  return null;
}

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

  // LUD-06: the invoice must carry sha256(metadata) as its description hash. Without that binding the
  // callback (possibly on another host, possibly after a redirect) decides who is paid and the typed
  // address proves nothing about the payee.
  const metadata = typeof payee.metadata === 'string' ? payee.metadata : '';
  if (!metadata) {
    throw new SkillError('ADDRESS_REFUSED', 'That address serves no metadata, so the invoice cannot be tied to it');
  }
  const callback = new URL(payee.callback);
  callback.searchParams.set('amount', String(msat));
  const invoice = (await getJson(callback.toString())).pr;
  if (typeof invoice !== 'string' || invoiceAmountMsat(invoice) !== BigInt(msat)) {
    throw new SkillError('ADDRESS_REFUSED', 'The payee returned an invoice for a different amount, so it was not sent to the owner');
  }
  const expectedHash = createHash('sha256').update(metadata).digest('hex');
  const gotHash = invoiceDescriptionHash(invoice);
  if (gotHash !== expectedHash) {
    throw new SkillError('ADDRESS_REFUSED',
      `The invoice is not bound to the address it was requested for (description hash ${gotHash ? 'mismatch' : 'missing'})`);
  }
  return invoice;
}
