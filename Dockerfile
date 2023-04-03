FROM node:14
WORKDIR /var/app/current

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
