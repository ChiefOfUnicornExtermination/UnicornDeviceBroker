# Use official Node.js runtime as base
FROM node:24-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY server.js .

# Copy static UI files into the image
COPY public/ ./public

# Copy firmware files for OTA (place compiled .bin here before deploying)
COPY firmware_files/ /firmware/

# Expose port
EXPOSE 8080

# Set environment
ENV PORT=8080
ENV FIRMWARE_DIR=/firmware

# Start the server
CMD ["npm", "start"]
