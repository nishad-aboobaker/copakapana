import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { UiHostComponent } from './shared/ui-host.component';

@Component({
  imports: [RouterOutlet, UiHostComponent],
  selector: 'app-root',
  // Layout containers stay Eager so change detection always reaches the routed pages
  // (Angular 22 makes components OnPush by default).
  changeDetection: ChangeDetectionStrategy.Eager,
  styleUrl: './app.scss',
  templateUrl: './app.html',
})
export class App {
  protected readonly title = signal('client');
}
