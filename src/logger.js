import pino from "pino";
import pretty from "pino-pretty";
import { config } from "./config.js";

const opts = {
  level: config.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
};
const stream = config.pretty
  ? pretty({
      colorize: false,
      sync: true,
      translateTime: "SYS:yyyy-mm-dd HH:MM:ss",
      ignore: "pid,hostname",
    })
  : undefined;

export const log = stream ? pino(opts, stream) : pino(opts);
// Baileys is very chatty at info level, so it gets its own (quieter) level.
export const baileysLog = log.child(
  { mod: "baileys" },
  { level: config.baileysLogLevel },
);
