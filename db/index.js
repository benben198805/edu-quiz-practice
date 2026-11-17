const sequelize = require("./connection");
const models = require("./models");

module.exports = { sequelize, ...models };
