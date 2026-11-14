/** Test preload (bunfig.toml): never read the user's real settings or open a real Popup. */
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DW_CONFIG = join(tmpdir(), `dw-test-config-${process.pid}-does-not-exist.json`);
delete process.env.DW_POPUP;
