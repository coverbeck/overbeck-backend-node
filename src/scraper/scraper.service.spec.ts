import {HttpModule} from "@nestjs/common";
import {Test, TestingModule} from '@nestjs/testing';
import {ScraperService} from './scraper.service';

describe('ScraperService', () => {
    let service: ScraperService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            imports: [HttpModule],
            providers: [ScraperService],
        }).compile();

        service = module.get<ScraperService>(ScraperService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });

    it('should fetch', done => {
        service.scrapeForUrl('https://www.gocomics.com/calvinandhobbes/2020/04/29', 'div[data-image^=https]', 'image')
            .subscribe(url => {
                expect(url).toEqual("https://assets.amuniversal.com/eb1256a04acc0138f109005056a9545d");
                done();
            });
    });
});
