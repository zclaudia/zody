use std::env;
use std::ffi::OsStr;
use std::process;

const NAME: &str = "Zody Computer Use Diagnostic";
const VERSION: &str = "0.1.0";
const INVALID_ARGUMENTS: &str = "error: expected exactly one of --health, --help, or --version\n";

const HEALTH: &str = concat!(
    "{\"schemaVersion\":1,",
    "\"kind\":\"zody-cua-helper-diagnostic-health\",",
    "\"diagnosticOnly\":true,",
    "\"inputCapable\":false,",
    "\"driverLinked\":false,",
    "\"tccRequested\":false,",
    "\"stdinRead\":false,",
    "\"networkUsed\":false,",
    "\"applicationFileIoUsed\":false,",
    "\"subprocessSpawned\":false,",
    "\"systemInputUsed\":false,",
    "\"nativeCapabilityProven\":false}\n"
);

const HELP: &str = concat!(
    "Zody Computer Use Diagnostic\n",
    "Diagnostic-only helper. It does not provide input or native Computer Use capability.\n\n",
    "Usage:\n",
    "  Zody Computer Use Diagnostic --health\n",
    "  Zody Computer Use Diagnostic --help\n",
    "  Zody Computer Use Diagnostic --version\n\n",
    "Exit codes:\n",
    "  0  diagnostic succeeded\n",
    "  2  missing, unknown, or extra arguments\n"
);

fn main() {
    let mut arguments = env::args_os().skip(1);
    let first = arguments.next();
    let second = arguments.next();

    let Some(argument) = first else {
        fail_closed();
    };
    if second.is_some() {
        fail_closed();
    }

    if argument == OsStr::new("--health") {
        print!("{HEALTH}");
        return;
    }
    if argument == OsStr::new("--help") {
        print!("{HELP}");
        return;
    }
    if argument == OsStr::new("--version") {
        println!("{NAME} {VERSION} (diagnostic-only)");
        return;
    }

    fail_closed();
}

fn fail_closed() -> ! {
    eprint!("{INVALID_ARGUMENTS}");
    process::exit(2);
}
