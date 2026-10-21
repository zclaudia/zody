export function buildLaunchCommand(
  executable,
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== "win32") return { command: executable, args, shell: false };

  const command = env.ComSpec || env.COMSPEC || "cmd.exe";
  const commandLine = [executable, ...args].map(quoteCmdArgument).join(" ");
  return { command, args: ["/d", "/s", "/c", `call ${commandLine}`], shell: false };
}

function quoteCmdArgument(value) {
  const argument = String(value).replaceAll("%", "%%").replaceAll("!", "^^!");
  return `"${argument.replaceAll('"', '""')}"`;
}
