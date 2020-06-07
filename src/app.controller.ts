import { Controller, Get, Query, Res } from '@nestjs/common';
import { AppService } from './app.service';
import { CovidService } from './covid/covid.service';
import { ScraperService } from './scraper/scraper.service';

@Controller()
export class AppController {
  constructor(private readonly scraperService: ScraperService, private covidService: CovidService,
              private appService: AppService) {}

  @Get("comics")
  getComic(@Query('comic') comic = 'calvin', @Query('apikey') apikey, @Res() response)  {
    if (!this.appService.authorize(apikey)) {
      response.status(403).send('Forbidden');
    }
    if (!this.scraperService.validateComic(comic)) {
      response.status(400).send('Bad request');
    }
    this.scraperService
      .getTodaysImage(comic, 'div[data-image^=https]', 'image')
      .subscribe(resp => {
          response.set('Content-Type', resp.headers['content-type']);
          response.set('Content-Disposition', resp.headers['content-disposition']);
          response.set('Content-Transfer-Encoding', resp.headers['content-transfer-encoding']);
          response.send(resp.data);
        },
        (/*error*/) => response.status(500).send()
      );
  }

  @Get("covid")
  getCovid() {
    return this.covidService.getCaliforniaCovidData();
  }
}
