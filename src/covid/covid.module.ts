import {HttpModule, Module} from '@nestjs/common';
import {CsvModule} from "nest-csv-parser";
import { CovidService } from './covid.service';

@Module({
  imports: [HttpModule, CsvModule],
  providers: [CovidService],
  exports: [CsvModule]
})
export class CovidModule {}
