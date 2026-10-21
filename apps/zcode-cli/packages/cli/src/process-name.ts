export const CLI_COMMAND_NAME = "zody";
export const CLI_PROCESS_NAME = "zody-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (target: ProcessTitleTarget = process): void => {
  target.title = CLI_PROCESS_NAME;
};
