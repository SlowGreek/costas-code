#!/usr/bin/env node

import { computeSourceSnapshot, lifecycleRoots, writeLifecycleSourceReceipt } from './desktop-lifecycle.mjs'

const roots = lifecycleRoots()
const snapshot = computeSourceSnapshot(roots)
const receipt = writeLifecycleSourceReceipt({ desktopRoot: roots.desktopRoot, snapshot })
console.log(`[write-lifecycle-source] ${receipt.source_revision} / ${receipt.ae_generation}`)
