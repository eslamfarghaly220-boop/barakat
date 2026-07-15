FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev

COPY . .
RUN mkdir -p data uploads

EXPOSE 3000

CMD ["npm", "start"]
