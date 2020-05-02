import { Module } from '@nestjs/common';
import {CsvModule} from "nest-csv-parser";
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {CovidService} from "./covid/covid.service";
import { ScraperModule } from './scraper/scraper.module';
import {ScraperService} from "./scraper/scraper.service";
import { CovidModule } from './covid/covid.module';

@Module({
  imports: [ScraperModule, CovidModule],
  controllers: [AppController],
  providers: [AppService, ScraperService, CovidService],
})
export class AppModule {}
