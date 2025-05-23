import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import winston from 'winston';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const logFile = join(__dirname, '..', 'planning.log');

// Maak het logbestand leeg bij opstarten
if (fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, '');
}

const winstonLogger = winston.createLogger({
  level: 'debug',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level}]: ${message}`;
        })
      )
    }),
    new winston.transports.File({ 
      filename: logFile,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
          return `${timestamp} [${level}]: ${message}`;
        })
      )
    })
  ]
});

// Handle uncaught exceptions and unhandled rejections
winstonLogger.exceptions.handle(
    new winston.transports.File({ filename: 'exceptions.log' })
);

winstonLogger.rejections.handle(
    new winston.transports.File({ filename: 'rejections.log' })
);

// Create a logger object with compatibility layer
const logger = {
    info: (message: string | { message: string }) => {
        const msg = typeof message === 'string' ? message : message.message;
        winstonLogger.info(msg);
    },
    warn: (message: string | { message: string }) => {
        const msg = typeof message === 'string' ? message : message.message;
        winstonLogger.warn(msg);
    },
    error: (message: string | { message: string }) => {
        const msg = typeof message === 'string' ? message : message.message;
        winstonLogger.error(msg);
    },
    log: (message: string | { message: string }) => {
        const msg = typeof message === 'string' ? message : message.message;
        winstonLogger.info(msg);
    },
    debug: (message: string | { message: string }) => {
        const msg = typeof message === 'string' ? message : message.message;
        winstonLogger.debug(msg);
    }
};

export default logger; 