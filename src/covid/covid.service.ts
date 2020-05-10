import {HttpService, Injectable} from '@nestjs/common';
import {CsvParser} from "nest-csv-parser";
import { Observable, of } from 'rxjs';
import {map, mergeMap} from "rxjs/operators";
import {Readable} from "stream";
import { BrainDeadCache } from '../BrainDeadCache';

class CovidRow {
  "County Name": string = "";
  "Most Recent Date": string = "";
  "Total Count Confirmed": string;
  "Total Count Deaths": string;
  "COVID-19 Positive Patients": string;
  "Suspected COVID-19 Positive Patients": string;
  "ICU COVID-19 Positive Patients": string;
  "ICU COVID-19 Suspected Patients": string;
}

@Injectable()
export class CovidService {
  private brainDeadCache: BrainDeadCache;
  constructor(private httpService: HttpService, private csvParser: CsvParser) {
    this.brainDeadCache = new BrainDeadCache();
  }

  getCaliforniaCovidData() {
    const covidData = this.brainDeadCache.getData();
    if (covidData) {
      return of(covidData);
    }
    return this.getCvsUrl()
      .pipe(
        mergeMap(csvUrl => this.httpService.get(csvUrl)),
        map(resp => resp.data),
        mergeMap(data => {
          return this.csvParser.parse(Readable.from(data), CovidRow, null, 0, {separator: ','});
        }),
        map(data => {
          this.brainDeadCache.setData(data.list);
          return data.list;
        })
      );
  }

  private getCvsUrl(): Observable<string> {
    return this.httpService.get(" https://data.chhs.ca.gov/api/3/action/package_search?q=covid")
      .pipe(
        map(resp => resp.data.result.results),
        map(data => {
          const covid = data.find(d => d.name === "california-covid-19-hospital-data-and-case-statistics");
          const resource = covid.resources.find(f => f.format === 'CSV');
          return resource.url;
        })
      );
  }
}
