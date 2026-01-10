#!/usr/bin/env node

// Suppress Node.js experimental warnings (specifically for SQLite)
process.env.NODE_NO_WARNINGS = "1";

import { main } from "../output/Main/index.js";

main();
