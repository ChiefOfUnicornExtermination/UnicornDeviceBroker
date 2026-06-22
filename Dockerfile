# Use official Node.js runtime as base
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY server.js .

# Expose port
EXPOSE 8080

# Set environment
ENV PORT=8080

# Start the server
CMD ["npm", "start"]
