import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { CovidModule } from './covid/covid.module';
import { CovidService } from './covid/covid.service';
import { ScraperModule } from './scraper/scraper.module';
import { ScraperService } from './scraper/scraper.service';

@Module({
  imports: [ScraperModule, CovidModule],
  controllers: [AppController],
  providers: [AppService, ScraperService, CovidService],
})
export class AppModule {}
