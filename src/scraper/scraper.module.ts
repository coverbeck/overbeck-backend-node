import {HttpModule, Module} from '@nestjs/common';
import { ScraperService } from './scraper.service';

@Module({
  imports: [HttpModule],
  providers: [ScraperService],
  exports: [HttpModule]
})
export class ScraperModule {}
