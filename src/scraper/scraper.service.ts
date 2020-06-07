// eslint-disable-next-line @typescript-eslint/no-var-requires
const cheerio = require('cheerio');
import { HttpService, Injectable } from '@nestjs/common';
import { AxiosResponse } from 'axios';
import { Observable } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';

const BASE_URL = 'https://www.gocomics.com';
const COMICS_MAP: { [key: string]: string} = {
    'adam': 'adamathome',
    'calvin': 'calvinandhobbes',
    'duplex': 'duplex',
    'nancy': 'nancy',
    'pooch': 'poochcafe'
}

@Injectable()
export class ScraperService {

    constructor(private httpService: HttpService) {
    }

    getImage(url: string, selector: string, dataAttributeName: string): Observable<AxiosResponse<any>> {
        return this.scrapeForUrl(url, selector, dataAttributeName)
            .pipe(
                mergeMap(imageUrl => this.httpService.get(imageUrl, {responseType: 'arraybuffer'}))
            );
    }
    scrapeForUrl(url: string, selector: string, dataAttributeName: string): Observable<string> {
        return this.httpService.get(url)
            .pipe(
                map(resp => resp.data),
                map(data => {
                    const $ = cheerio.load(data);
                    const theUrl: string = $(selector).data(dataAttributeName);
                    return theUrl;
                }));
    }

    validateComic(comic: string): boolean {
        return !!COMICS_MAP[comic];
    }

    private buildUrl(comic: string): string {
        const theComic = COMICS_MAP[comic];
        const date = new Date();
        return `${BASE_URL}/${theComic}/${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
    }

    getTodaysImage(comic: any, divDataImageHttps: string, image: string) {
        return this.getImage(this.buildUrl(comic), divDataImageHttps, image);
    }
}
