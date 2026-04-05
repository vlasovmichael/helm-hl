import winston from 'winston';
import 'dotenv/config';

const { combine, timestamp, printf, colorize } = winston.format;

const myFormat = printf(({ level, message, timestamp }) => {
    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

export const logger = winston.createLogger({
    level: 'info',
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        myFormat
    ),
    transports: [
        new winston.transports.Console({
            format: combine(colorize(), myFormat)
        }),
        new winston.transports.File({ 
            filename: 'logs/app.log',
            maxsize: 5242880,
            maxFiles: 5
        })
    ]
});
