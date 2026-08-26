FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js .
COPY firmware_files/ /firmware/
EXPOSE 8080
CMD ["node", "server.js"]
