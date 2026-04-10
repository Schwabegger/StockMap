FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY server.js .
COPY inventory.html .

# Data and images are mounted as volumes — not baked into the image
# so your stock.json and photos survive container restarts/updates

EXPOSE 3000

CMD ["node", "server.js"]
