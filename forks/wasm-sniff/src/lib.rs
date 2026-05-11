//! Throwaway WASM-compatibility sniff for rgb-ops + rgb-schemas under our
//! forked bp-core family. The crate body just touches the deps so the
//! linker doesn't dead-code-eliminate them.

// Lib names (not package names): rgb-consensus → rgbcore, rgb-ops → rgbstd,
// rgb-schemas → schemata. The rgb-ops lib explicitly declares cdylib for
// WASM in its Cargo.toml — they planned for this use case.
#[allow(unused_imports)]
use rgbcore as _;
#[allow(unused_imports)]
use rgbstd as _;
#[allow(unused_imports)]
use schemata as _;
