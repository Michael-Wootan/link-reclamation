#!/usr/bin/env node
'use strict';
/**
 * Offline checks for the linked / mentioned / neither classification.
 * No network, no API keys. Uses the committed example config.
 *
 *   npm test
 */
const assert = require('assert');
const { classifyBody } = require('../src/link-reclamation');

// A real link to our domain
assert.deepStrictEqual(
  classifyBody('<p>We buy from <a href="https://acmesupply.example/shop">Acme Supply</a>.</p>'),
  { linked: true, mentioned: true });

// The brand is named but not linked: this is the reclamation opportunity
assert.deepStrictEqual(
  classifyBody('<p>Our beans come from Acme Supply, a great roaster.</p>'),
  { linked: false, mentioned: true });

// The domain appears as plain text, not inside an anchor: still not a link
assert.strictEqual(classifyBody('<p>See acmesupply.example for details.</p>').linked, false);

// A link to someone else, no mention of us
assert.deepStrictEqual(
  classifyBody('<a href="https://other-site.example">Other</a>'),
  { linked: false, mentioned: false });

// A similar-looking domain is not ours
assert.strictEqual(classifyBody('<a href="https://acmesupplyXexample.test">x</a>').linked, false);

console.log('ok: 5 classification checks passed');
