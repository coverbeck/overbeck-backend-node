const express = require('express');
const nunjucks = require('nunjucks');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

nunjucks.configure(path.join(__dirname, 'views'), {
  autoescape: true,
  express: app,
});

app.set('view engine', 'njk');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/', require('./routes/index'));

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
