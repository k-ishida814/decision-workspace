#!/usr/bin/env bun
/** Development entry point; the released binary runs the same code as `dw hook`. */
import { hookMain } from "./entry";

await hookMain();
