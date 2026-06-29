FROM node:18-alpine
WORKDIR /app
COPY vps-monitor/package*.json ./
RUN npm install --production
COPY vps-monitor/monitor.js ./
COPY index.html naqd-gateway.html ./
CMD [ "node", "monitor.js" ]
