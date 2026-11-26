import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { invoiceDescriptionHash, invoiceFromAddress } from '../src/lightning.mjs';

// A real mainnet 21-sat invoice whose payee node is unrelated to the address it is served for, and which
// carries NO description hash (description "L29 wrong payee"). This is what a hostile callback returns.
const UNBOUND = JSON.parse(readFileSync(new URL('../fixtures/wrong-payee-invoice.json', import.meta.url), 'utf8')).invoice;

// A live Wallet of Satoshi invoice (1 sat) and the metadata document it belongs to. Its BOLT11 `h` field is
// sha256(metadata) — the spec-shaped case the fix must keep working, across the vendor's own split hosts.
const PRODUCTION = JSON.parse(readFileSync(new URL('../fixtures/production-invoice.json', import.meta.url), 'utf8')).invoice;
const PRODUCTION_METADATA = JSON.parse(readFileSync(new URL('../fixtures/production-payee.json', import.meta.url), 'utf8')).metadata;

function payeeDocument(callback, metadata = PRODUCTION_METADATA) {
  return {
    tag: 'payRequest',
    callback,
    minSendable: 1000,
    maxSendable: 100_000_000_000,
    metadata,
  };
}

function serve({ address, callback, invoice = UNBOUND, metadata }) {
  globalThis.fetch = async url => {
    const href = String(url);
    if (href === address) return Response.json(payeeDocument(callback, metadata));
    if (href.startsWith(callback)) return Response.json({pr: invoice});
    throw new Error(`unexpected fetch ${href}`);
  };
}

test('the description hash of a real invoice is readable', () => {
  assert.equal(invoiceDescriptionHash(PRODUCTION), '36c3388b0a44d545ae8e0e978a17666d094895b71781e46c13ee44731317cf0e');
  assert.equal(invoiceDescriptionHash(UNBOUND), null);
});

test('an invoice that is not bound to the payee metadata is refused', async () => {
  // alice@payee.test advertises its callback on cb.test and that server answers with the unbound invoice,
  // so the caller is told it is paying alice@payee.test while the money can go to any node.
  serve({ address: 'https://payee.test/.well-known/lnurlp/alice', callback: 'https://cb.test/cb' });

  await assert.rejects(invoiceFromAddress('alice@payee.test', 21), {
    code: 'ADDRESS_REFUSED',
    message: /description hash missing/,
  });
});

test('a description hash for different metadata is refused', async () => {
  // The callback returns an invoice whose h is bound to someone else's metadata.
  serve({
    address: 'https://payee.test/.well-known/lnurlp/alice',
    callback: 'https://payee.test/cb',
    invoice: PRODUCTION,
    metadata: JSON.stringify([['text/plain', 'mallory']]),
  });

  await assert.rejects(invoiceFromAddress('alice@payee.test', 1), {
    code: 'ADDRESS_REFUSED',
    message: /description hash mismatch/,
  });
});

test('a same-host callback that lands on an unbound invoice is still refused', async () => {
  // What a 302 to another origin looks like after fetch has followed it: same host, foreign invoice.
  serve({ address: 'https://payee.test/.well-known/lnurlp/alice', callback: 'https://payee.test/cb' });

  await assert.rejects(invoiceFromAddress('alice@payee.test', 21), {code: 'ADDRESS_REFUSED'});
});

test('the vendor production shape — split hosts with a bound invoice — still pays', async () => {
  serve({
    address: 'https://walletofsatoshi.com/.well-known/lnurlp/medicalsail99',
    callback: 'https://livingroomofsatoshi.com/api/v1/lnurl/payreq/cd547ecc',
    invoice: PRODUCTION,
  });

  assert.equal(await invoiceFromAddress('medicalsail99@walletofsatoshi.com', 1), PRODUCTION);
});
