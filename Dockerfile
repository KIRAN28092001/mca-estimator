FROM node:20-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY client/package*.json client/
RUN npm --prefix client ci
COPY . .
RUN npm run build && rm -rf client/node_modules
ENV PORT=3000 MCA_DB=/app/data/estimator.db
EXPOSE 3000
VOLUME /app/data
CMD ["node", "server/index.js"]
