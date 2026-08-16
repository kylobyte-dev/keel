import {
  Array,
  Cause,
  Inspectable,
  Logger,
  LogLevel,
  References,
} from "effect";
import type { FastifyBaseLogger } from "fastify";
import pino from "pino";

export const pinoInstance = pino({
  redact: ["headers.authorization"],
  transport: {
    target: "pino-pretty",
  },
});

export const PinoLogger = Logger.make<unknown, void>(
  ({ cause, date, fiber, logLevel, message }) => {
    if (logLevel === "None") {
      return;
    }

    const now = date.getTime();
    const annotationsObj: Record<string, unknown> = {};
    const spansObj: Record<string, number> = {};

    for (const [key, value] of Object.entries(
      fiber.getRef(References.CurrentLogAnnotations),
    )) {
      annotationsObj[key] = structuredMessage(value);
    }

    for (const [label, startTime] of fiber.getRef(References.CurrentLogSpans)) {
      spansObj[label] = now - startTime;
    }

    const messageArr = Array.ensure(message);

    const formattedMessage: string | undefined =
      messageArr.length === 0 ? undefined : structuredMessage(messageArr[0]);

    const data = {
      cause: cause.reasons.length === 0 ? undefined : Cause.pretty(cause),
      annotations: annotationsObj,
      spans: spansObj,
      fiberId: `#${fiber.id}`,
    };

    const logFn = logLevelMap[logLevel];

    pinoInstance[logFn](data, formattedMessage);
  },
);

const structuredMessage = (value: unknown) => {
  switch (typeof value) {
    case "bigint":
    case "function":
    case "symbol": {
      return String(value);
    }
    default: {
      return Inspectable.toJson(value) as string;
    }
  }
};

const logLevelMap = {
  All: "info",
  Debug: "debug",
  Error: "error",
  Fatal: "fatal",
  Info: "info",
  Trace: "trace",
  Warn: "warn",
} satisfies Record<Exclude<LogLevel.LogLevel, "None">, keyof FastifyBaseLogger>;
