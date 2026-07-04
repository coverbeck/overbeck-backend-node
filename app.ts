import express from 'express';
import nunjucks from 'nunjucks';
import path from 'path';
import { fileURLToPath } from 'url';
import indexRouter from './routes/index.ts';
import { requireOriginSecret } from './middleware/originVerify.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

nunjucks.configure(path.join(__dirname, 'views'), {
  autoescape: true,
  express: app,
});

app.set('view engine', 'njk');

app.use(requireOriginSecret);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use('/', indexRouter);

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
