import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { invoiceFromAddress } from '../src/lightning.mjs';

// A real mainnet 21-sat invoice whose payee node is 4fa1e8cf9843486e1f38a60ce58161adae0cf3f99091bf5b50e2e56bc92cb350
// (created for this test from a Wallet of Satoshi wallet; description "L29 wrong payee").
const INVOICE = JSON.parse(
  readFileSync(new URL('../fixtures/wrong-payee-invoice.json', import.meta.url), 'utf8'),
).invoice;

const payeeDocument = callback => ({
  tag: 'payRequest',
  callback,
  minSendable: 1000,
  maxSendable: 100_000_000,
  metadata: JSON.stringify([['text/plain', 'alice']]),
});

function serve({ address, callback }) {
  globalThis.fetch = async url => {
    const href = String(url);
    if (href === address) return Response.json(payeeDocument(callback));
    if (href.startsWith(callback)) return Response.json({pr: INVOICE});
    throw new Error(`unexpected fetch ${href}`);
  };
}

test('an address whose callback lives on another origin is refused', async () => {
  // alice@payee.test advertises its callback on cb.test, a server the address owner
  // does not name. The invoice below pays a node that has no relation to payee.test,
  // yet the caller is told it is paying alice@payee.test.
  serve({
    address: 'https://payee.test/.well-known/lnurlp/alice',
    callback: 'https://cb.test/cb',
  });

  await assert.rejects(
    invoiceFromAddress('alice@payee.test', 21),
    {code: 'ADDRESS_REFUSED'},
    'a cross-origin callback means the invoice can pay any node',
  );
});

test('an address whose callback stays on its own origin still pays', async () => {
  serve({
    address: 'https://payee.test/.well-known/lnurlp/alice',
    callback: 'https://payee.test/cb',
  });

  assert.equal(await invoiceFromAddress('alice@payee.test', 21), INVOICE);
});
