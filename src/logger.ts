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
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }),
    new winston.transports.File({ 
      filename: logFile,
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
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
    info: (message: string | { message: string }) => winstonLogger.info(typeof message === 'string' ? { message } : message),
    warn: (message: string | { message: string }) => winstonLogger.warn(typeof message === 'string' ? { message } : message),
    error: (message: string | { message: string }) => winstonLogger.error(typeof message === 'string' ? { message } : message),
    log: (message: string | { message: string }) => winstonLogger.info(typeof message === 'string' ? { message } : message)
};

export default logger; 