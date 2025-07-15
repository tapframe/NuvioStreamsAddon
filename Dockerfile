# Use official Node.js runtime as base image
FROM node:18-alpine AS base

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY . .

# Remove unnecessary files for production
RUN rm -rf .git .github _td_files test_* *.md .env.example

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nuvio -u 1001

# Change ownership of app directory
RUN chown -R nuvio:nodejs /app
USER nuvio

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application
CMD ["npm", "start"]